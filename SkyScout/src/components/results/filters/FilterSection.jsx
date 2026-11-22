

function FilterSection({title, children}) {
    return (
        <section className="mt-10 border-gray-100 pt-8 first:mt-10 first:border-0 first:pt-0">
            <h3 className="mb-5 text-sm font-semibold uppercase tracking-wider text-gray-500">
                {title}
            </h3>

            {children}
        </section>
    )
}

export default FilterSection;